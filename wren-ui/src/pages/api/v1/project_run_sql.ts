import { NextApiRequest, NextApiResponse } from 'next';
import { components } from '@/common';
import { ApiType } from '@server/repositories/apiHistoryRepository';
import * as Errors from '@/apollo/server/utils/error';
import {
  ApiError,
  handleApiError,
  respondWith,
} from '@/apollo/server/utils/apiUtils';
import { PreviewDataResponse } from '@server/services/queryService';
import { transformToObjects } from '@server/utils/dataUtils';
import { getLogger } from '@server/utils';

const logger = getLogger('API_PROJECT_RUN_SQL');
logger.level = 'debug';

const { deployService, projectService, queryService } = components;

interface ProjectRunSqlRequest {
  projectId?: number | string;
  project_id?: number | string;
  sql: string;
  limit?: number;
  threadId?: string;
}

const parseProjectId = (value: unknown) => {
  const projectId = Number(value);
  return Number.isInteger(projectId) && projectId > 0 ? projectId : null;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const body = req.body as ProjectRunSqlRequest;
  const startTime = Date.now();
  const projectId = parseProjectId(body.project_id ?? body.projectId);
  let project;

  try {
    if (req.method !== 'POST') {
      throw new ApiError('Method not allowed', 405);
    }

    if (!projectId) {
      throw new ApiError('project_id is required', 400);
    }

    if (!body.sql) {
      throw new ApiError('SQL is required', 400);
    }

    const requestedLimit = Number(body.limit || 500);
    if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
      throw new ApiError('Invalid limit', 400);
    }
    const limit = Math.max(1, Math.min(requestedLimit, 10000));

    project = await projectService.getProjectById(projectId);
    if (!project) {
      throw new ApiError(`Project ${projectId} was not found`, 404);
    }

    const lastDeploy = await deployService.getLastDeployment(project.id);
    if (!lastDeploy) {
      throw new ApiError(
        'No deployment found, please deploy your project first',
        400,
        Errors.GeneralErrorCodes.NO_DEPLOYMENT_FOUND,
      );
    }

    let queryResult: PreviewDataResponse;
    try {
      queryResult = (await queryService.preview(body.sql, {
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

    await respondWith({
      res,
      statusCode: 200,
      responsePayload: {
        projectId: project.id,
        projectName: project.displayName,
        sql: body.sql,
        records,
        columns: queryResult.columns,
        data: queryResult.data,
        totalRows: records.length,
        cacheHit: queryResult.cacheHit,
        cacheCreatedAt: queryResult.cacheCreatedAt,
        cacheOverrodeAt: queryResult.cacheOverrodeAt,
        override: queryResult.override,
        threadId: body.threadId,
      },
      projectId: project.id,
      apiType: ApiType.ASK,
      startTime,
      requestPayload: req.body,
      threadId: body.threadId,
      headers: req.headers as Record<string, string>,
    });
  } catch (error) {
    await handleApiError({
      error,
      res,
      projectId: project?.id,
      apiType: ApiType.ASK,
      requestPayload: req.body,
      threadId: body.threadId,
      headers: req.headers as Record<string, string>,
      startTime,
      logger,
    });
  }
}
