import express from 'express';
import protect from '../middleware/AuthMiddleware.js';
import { krogerSearch, krogerSearchStream, krogerTestEval } from '../controllers/KrogerController.js';
import {
  krogerLogin,
  krogerCallback,
  addToKrogerCart,
  getKrogerCartSnapshot,
} from '../controllers/KrogerOAuthController.js';

const router = express.Router();

router.post('/search', krogerSearch);
router.post('/test-eval', krogerTestEval);
router.get('/search/stream', krogerSearchStream);

// OAuth (UNPROTECTED — browser navigations won’t include your API token)
router.get('/oauth/login', krogerLogin);
router.get('/oauth/callback', krogerCallback);

// Cart (PROTECTED — called from your app with API auth)
router.post('/cart/add', protect, addToKrogerCart);
router.get('/cart/snapshot', protect, getKrogerCartSnapshot);

export default router;
