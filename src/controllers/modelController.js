import { isSupportedCli, SUPPORTED_CLIS } from '../services/cliMapper.js';
import { getModelCatalog } from '../services/modelService.js';
import { HttpError } from '../utils/httpError.js';

// GET /api/models/:cli
export async function listModels(req, res) {
  const { cli } = req.params;
  if (!isSupportedCli(cli)) {
    throw new HttpError(400, `"cli" must be one of: ${SUPPORTED_CLIS.join(', ')}`);
  }
  res.json(await getModelCatalog(cli));
}
