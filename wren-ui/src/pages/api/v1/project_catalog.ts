import { NextApiRequest, NextApiResponse } from 'next';
import { components } from '@/common';
import { ApiType } from '@server/repositories/apiHistoryRepository';
import {
  ApiError,
  handleApiError,
  respondWithSimple,
} from '@/apollo/server/utils/apiUtils';
import { getLogger } from '@server/utils';

const logger = getLogger('API_PROJECT_CATALOG');
logger.level = 'debug';

const { projectRepository, modelRepository, modelColumnRepository } =
  components;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const startTime = Date.now();

  try {
    if (req.method !== 'GET') {
      throw new ApiError('Method not allowed', 405);
    }

    const projects = await projectRepository.findAll({ order: 'id' });
    const catalog = await Promise.all(
      projects.map(async (project) => {
        const models = await modelRepository.findAllBy(
          { projectId: project.id },
          { order: 'source_table_name' },
        );
        const modelIds = models.map((model) => model.id);
        const columns = modelIds.length
          ? await modelColumnRepository.findColumnsByModelIds(modelIds)
          : [];
        const columnsByModelId = columns.reduce(
          (acc, column) => {
            acc[column.modelId] = acc[column.modelId] || [];
            acc[column.modelId].push({
              name: column.displayName,
              displayName: column.displayName,
              referenceName: column.referenceName,
              sourceColumnName: column.sourceColumnName,
              type: column.type,
            });
            return acc;
          },
          {} as Record<number, Record<string, string>[]>,
        );

        return {
          id: project.id,
          projectId: project.id,
          name: project.displayName,
          displayName: project.displayName,
          datasource: project.displayName,
          dataSource: project.displayName,
          type: project.type,
          catalog: project.catalog,
          schema: project.schema,
          sampleDataset: project.sampleDataset,
          tables: models.map((model) => model.sourceTableName).filter(Boolean),
          models: models.map((model) => ({
            id: model.id,
            name: model.displayName,
            displayName: model.displayName,
            referenceName: model.referenceName,
            sourceTableName: model.sourceTableName,
            columns: columnsByModelId[model.id] || [],
          })),
          columns: columns.map((column) => column.sourceColumnName).filter(Boolean),
        };
      }),
    );

    await respondWithSimple({
      res,
      statusCode: 200,
      responsePayload: {
        projects: catalog,
      },
      projectId: projects[0]?.id || 0,
      apiType: ApiType.ASK,
      startTime,
      requestPayload: req.query,
      headers: req.headers as Record<string, string>,
    });
  } catch (error) {
    await handleApiError({
      error,
      res,
      projectId: undefined,
      apiType: ApiType.ASK,
      requestPayload: req.query,
      headers: req.headers as Record<string, string>,
      startTime,
      logger,
    });
  }
}
