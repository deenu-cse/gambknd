import type { AuthContext } from '../middleware/auth.js';

declare global {
  namespace Express {
    interface Request {
      id: string;
      auth?: AuthContext;
    }
  }
}

export {};
