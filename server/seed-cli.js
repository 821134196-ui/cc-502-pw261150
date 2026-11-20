import { createDb } from './api.js';
import { seed } from './seed.js';

const db = createDb(process.env.MERIDIAN_DB || 'data/meridian.sqlite');
seed(db, { reset: true });
console.log('seed complete');
