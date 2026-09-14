import { Router } from 'express';
import { checkAgent, checkAllAgents, getAgents, patchAgent } from '../controllers/agentController.js';
import { getCronJobs, getCronRuns, patchCronJob, runCronJob } from '../controllers/cronController.js';
import { listNotifications, markAllRead, markRead, stream } from '../controllers/notificationController.js';
import { getOverview, getRecent, getTimeseries } from '../controllers/statsController.js';
import { createToken, deleteToken, listTokens, regenerateToken, revokeToken, updateToken } from '../controllers/tokenController.js';
import { createUser, deleteUser, listUsers, updateUser } from '../controllers/userController.js';
import { requireAdmin, requireSession } from '../middleware/auth.js';

/** Routes used by the dashboard (session cookie). Mounted at /api before the CLI API router. */
const router = Router();

router.use(['/tokens', '/agents', '/notifications', '/stats', '/users', '/cron'], requireSession);
router.use(['/users', '/cron'], requireAdmin);

router.get('/tokens', listTokens);
router.post('/tokens', createToken);
router.patch('/tokens/:id', updateToken);
router.post('/tokens/:id/revoke', revokeToken);
router.post('/tokens/:id/regenerate', regenerateToken);
router.delete('/tokens/:id', deleteToken);

router.get('/agents', getAgents);
router.post('/agents/check', checkAllAgents);
router.post('/agents/:cli/check', checkAgent);
router.patch('/agents/:cli', requireAdmin, patchAgent);

router.get('/notifications', listNotifications);
router.get('/notifications/stream', stream);
router.post('/notifications/read-all', markAllRead);
router.post('/notifications/:id/read', markRead);

router.get('/stats/overview', getOverview);
router.get('/stats/timeseries', getTimeseries);
router.get('/stats/recent', getRecent);

router.get('/users', listUsers);
router.post('/users', createUser);
router.patch('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);

router.get('/cron', getCronJobs);
router.get('/cron/:key/runs', getCronRuns);
router.post('/cron/:key/run', runCronJob);
router.patch('/cron/:key', patchCronJob);

export default router;
