import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, createDb } from './api.js';

const DB_FILE = process.env.MERIDIAN_DB || path.join(process.cwd(), 'data', 'meridian.sqlite');
const PORT = Number(process.env.PORT || 5175);

const db = createDb(DB_FILE);
const app = createApp(db);
app.listen(PORT, () => {
  console.log(`Meridian API listening on http://localhost:${PORT}  (db: ${DB_FILE})`);
});
