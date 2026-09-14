import { Router } from 'express';
import { authConfig, login, logout, me, register, updateProfile } from '../controllers/authController.js';
import { requireSession } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many attempts. Try again in a few minutes.',
});

router.get('/config', authConfig);
router.post('/register', credentialLimiter, register);
router.post('/login', credentialLimiter, login);
router.post('/logout', logout);
router.get('/me', requireSession, me);
router.patch('/me', requireSession, updateProfile);

export default router;
