import { NextApiRequest, NextApiResponse } from 'next';
import { components } from '@/common';
import { ApiType } from '@server/repositories/apiHistoryRepository';
import * as Errors from '@/apollo/server/utils/error';
import { v4 as uuidv4 } from 'uuid';
import {
  ApiError,
  handleApiError,
  isAskResultFinished,
  MAX_WAIT_TIME,
  respondWith,
  transformHistoryInput,
  validateSummaryResult,
} from '@/apollo/server/utils/apiUtils';
import {
  AskResult,
  AskResultType,
  ChartResult,
  ChartStatus,
  TextBasedAnswerInput,
  TextBasedAnswerResult,
  TextBasedAnswerStatus,
  WrenAIError,
  WrenAILanguage,
} from '@/apollo/server/models/adaptor';
import { PreviewDataResponse } from '@server/services/queryService';
import { Project } from '@server/repositories';
import { transformToObjects } from '@server/utils/dataUtils';
import { enhanceVegaSpec } from '@/utils/vegaSpecUtils';
import { getLogger } from '@server/utils';

const logger = getLogger('API_PROJECT_ASK');
logger.level = 'debug';

const {
  apiHistoryRepository,
  deployService,
  projectService,
  queryService,
  wrenAIAdaptor,
} = components;

interface ProjectAskRequest {
  question: string;
  projectId?: number | string;
  project_id?: number | string;
  datasourceId?: string;
  datasource_id?: string;
  sampleSize?: number;
  language?: string;
  threadId?: string;
  includeChart?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalize = (value: unknown) => String(value || '').trim().toLowerCase();

const parseProjectId = (value: unknown) => {
  const projectId = Number(value);
  return Number.isInteger(projectId) && projectId > 0 ? projectId : null;
};

const readStreamMessages = async (
  req: NextApiRequest,
  stream: any,
) => {
  let content = '';

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      const matches = text.matchAll(/data: {"message":"([\s\S]*?)"}/g);
      for (const match of matches) {
        if (match[1]) {
          content += match[1];
        }
      }
    });

    stream.on('end', () => resolve());
    stream.on('error', (error) => reject(error));
    req.on('close', () => {
      stream.destroy();
      reject(new Error('Client disconnected'));
    });
  });

  return content;
};

const validateDatasource = (project: Project, datasourceId?: string) => {
  const requested = normalize(datasourceId);
  if (!requested) {
    return;
  }

  const candidates = [
    project.id,
    project.displayName,
    project.type,
    project.catalog,
    project.schema,
    project.sampleDataset,
  ].map(normalize);

  if (!candidates.includes(requested)) {
    throw new ApiError(
      `datasource_id "${datasourceId}" does not belong to project ${project.id}`,
      400,
    );
  }
};

const validateChartResult = (result: ChartResult): void => {
  if (result.status === ChartStatus.FAILED || result.error) {
    throw new ApiError(
      result.error?.message || 'Failed to generate Vega spec',
      400,
      Errors.GeneralErrorCodes.FAILED_TO_GENERATE_VEGA_SCHEMA,
    );
  }

  if (!result?.response?.chartSchema) {
    throw new ApiError('Failed to generate Vega spec', 500);
  }
};

const pickLanguage = (
  project: Project,
  requestedLanguage?: string,
): string => {
  return (
    requestedLanguage ||
    WrenAILanguage[project.language] ||
    WrenAILanguage.EN
  );
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const body = req.body as ProjectAskRequest;
  const {
    question,
    sampleSize,
    language,
    threadId,
    includeChart = false,
  } = body;
  const startTime = Date.now();
  const projectId = parseProjectId(body.project_id ?? body.projectId);
  let project: Project | null = null;

  try {
    if (req.method !== 'POST') {
      throw new ApiError('Method not allowed', 405);
    }

    if (!question) {
      throw new ApiError('Question is required', 400);
    }

    if (!projectId) {
      throw new ApiError('project_id is required', 400);
    }

    const requestedLimit = Number(sampleSize || 500);
    if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
      throw new ApiError('Invalid sampleSize', 400);
    }
    const limit = Math.max(1, Math.min(requestedLimit, 10000));
    project = await projectService.getProjectById(projectId);
    if (!project) {
      throw new ApiError(`Project ${projectId} was not found`, 404);
    }

    validateDatasource(project, body.datasource_id ?? body.datasourceId);

    const lastDeploy = await deployService.getLastDeployment(project.id);
    if (!lastDeploy) {
      throw new ApiError(
        'No deployment found, please deploy your project first',
        400,
        Errors.GeneralErrorCodes.NO_DEPLOYMENT_FOUND,
      );
    }

    const newThreadId = threadId || uuidv4();
    const histories = threadId
      ? await apiHistoryRepository.findAllBy({ threadId })
      : undefined;

    const askTask = await wrenAIAdaptor.ask({
      query: question,
      deployId: lastDeploy.hash,
      projectId: String(project.id),
      histories: transformHistoryInput(histories) as any,
      configurations: {
        language: pickLanguage(project, language),
      },
    });

    const deadline = Date.now() + MAX_WAIT_TIME;
    let askResult: AskResult;
    while (true) {
      askResult = await wrenAIAdaptor.getAskResult(askTask.queryId);
      if (isAskResultFinished(askResult)) {
        break;
      }

      if (Date.now() > deadline) {
        throw new ApiError(
          'Timeout waiting for SQL generation',
          500,
          Errors.GeneralErrorCodes.POLLING_TIMEOUT,
        );
      }

      await sleep(1000);
    }

    if (askResult.error) {
      const errorMessage =
        (askResult.error as WrenAIError).message || 'Unknown error';
      const additionalData: Record<string, any> = {};
      if (askResult.invalidSql) {
        additionalData.invalidSql = askResult.invalidSql;
      }
      throw new ApiError(
        errorMessage,
        400,
        askResult.error?.code || Errors.GeneralErrorCodes.INTERNAL_SERVER_ERROR,
        additionalData,
      );
    }

    if (askResult.type === AskResultType.GENERAL) {
      const stream = await wrenAIAdaptor.getAskStreamingResult(askTask.queryId);
      const explanation = await readStreamMessages(req, stream);

      await respondWith({
        res,
        statusCode: 200,
        responsePayload: {
          type: 'NON_SQL_QUERY',
          explanation,
          summary: explanation,
          threadId: newThreadId,
          queryId: askTask.queryId,
          projectId: project.id,
          projectName: project.displayName,
          datasourceId: body.datasource_id ?? body.datasourceId,
        },
        projectId: project.id,
        apiType: ApiType.ASK,
        startTime,
        requestPayload: req.body,
        threadId: newThreadId,
        headers: req.headers as Record<string, string>,
      });
      return;
    }

    const sql = askResult.response?.[0]?.sql;
    if (!sql) {
      throw new ApiError('No SQL generated', 400);
    }

    let queryResult: PreviewDataResponse;
    try {
      queryResult = (await queryService.preview(sql, {
        project,
        limit,
        manifest: lastDeploy.manifest,
        modelingOnly: false,
      })) as PreviewDataResponse;
    } catch (queryError: any) {
      throw new ApiError(
        queryError.message || 'Error executing SQL query',
        400,
        Errors.GeneralErrorCodes.INVALID_SQL_ERROR,
      );
    }

    const records = transformToObjects(queryResult.columns, queryResult.data);

    const textBasedAnswerInput: TextBasedAnswerInput = {
      query: question,
      sql,
      sqlData: queryResult,
      threadId: newThreadId,
      configurations: {
        language: pickLanguage(project, language),
      },
    };
    const summaryTask =
      await wrenAIAdaptor.createTextBasedAnswer(textBasedAnswerInput);
    if (!summaryTask?.queryId) {
      throw new ApiError('Failed to start summary generation task', 500);
    }

    let summaryResult: TextBasedAnswerResult;
    while (true) {
      summaryResult = await wrenAIAdaptor.getTextBasedAnswerResult(
        summaryTask.queryId,
      );
      if (
        summaryResult.status === TextBasedAnswerStatus.SUCCEEDED ||
        summaryResult.status === TextBasedAnswerStatus.FAILED
      ) {
        break;
      }

      if (Date.now() > deadline) {
        throw new ApiError(
          'Timeout waiting for summary generation',
          500,
          Errors.GeneralErrorCodes.POLLING_TIMEOUT,
        );
      }

      await sleep(1000);
    }

    validateSummaryResult(summaryResult);
    const summary = await readStreamMessages(
      req,
      await wrenAIAdaptor.streamTextBasedAnswer(summaryTask.queryId),
    );

    let chart;
    let chartError;
    if (includeChart) {
      try {
        const chartTask = await wrenAIAdaptor.generateChart({
          query: question,
          sql,
          projectId: String(project.id),
          configurations: {
            language: pickLanguage(project, language),
          },
        });

        if (!chartTask?.queryId) {
          throw new ApiError('Failed to start Vega spec generation task', 500);
        }

        let chartResult: ChartResult;
        while (true) {
          chartResult = await wrenAIAdaptor.getChartResult(chartTask.queryId);
          if (
            chartResult.status === ChartStatus.FINISHED ||
            chartResult.status === ChartStatus.FAILED
          ) {
            break;
          }

          if (Date.now() > deadline) {
            throw new ApiError(
              'Timeout waiting for Vega spec generation',
              500,
              Errors.GeneralErrorCodes.POLLING_TIMEOUT,
            );
          }

          await sleep(1000);
        }

        validateChartResult(chartResult);
        chart = {
          ...chartResult.response,
          vegaSpec: enhanceVegaSpec(
            chartResult.response?.chartSchema || {},
            records,
          ),
        };
      } catch (error: any) {
        chartError = error.message || String(error);
      }
    }

    await respondWith({
      res,
      statusCode: 200,
      responsePayload: {
        question,
        projectId: project.id,
        projectName: project.displayName,
        datasourceId: body.datasource_id ?? body.datasourceId,
        sql,
        summary,
        threadId: newThreadId,
        queryId: askTask.queryId,
        result: {
          records,
          columns: queryResult.columns,
          data: queryResult.data,
          totalRows: records.length,
          cacheHit: queryResult.cacheHit,
          cacheCreatedAt: queryResult.cacheCreatedAt,
          cacheOverrodeAt: queryResult.cacheOverrodeAt,
          override: queryResult.override,
        },
        chart,
        chartError,
      },
      projectId: project.id,
      apiType: ApiType.ASK,
      startTime,
      requestPayload: req.body,
      threadId: newThreadId,
      headers: req.headers as Record<string, string>,
    });
  } catch (error) {
    await handleApiError({
      error,
      res,
      projectId: project?.id,
      apiType: ApiType.ASK,
      requestPayload: req.body,
      threadId,
      headers: req.headers as Record<string, string>,
      startTime,
      logger,
    });
  }
}
