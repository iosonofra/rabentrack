import { parentPort } from 'node:worker_threads';
import { previewCronExpression } from './cron-scheduler.js';

parentPort.on('message', ({ id, expression, options }) => {
  try { parentPort.postMessage({ id, result: previewCronExpression(expression, options) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
