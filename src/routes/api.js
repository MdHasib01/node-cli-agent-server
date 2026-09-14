import { Router } from 'express';
import { generate } from '../controllers/generateController.js';
import { getJobById, listClis, usage } from '../controllers/statusController.js';

const router = Router();

router.get('/clis', listClis);
router.post('/generate', generate);
router.get('/jobs/:id', getJobById);
router.get('/usage', usage);

export default router;
