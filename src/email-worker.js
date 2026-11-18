import { parentPort, workerData } from 'node:worker_threads';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport(workerData.options);
try {
  const info = await transporter.sendMail(workerData.message);
  parentPort.postMessage({ ok: true, messageId: info.messageId });
} catch (error) {
  parentPort.postMessage({ error: error.message, code: error.code, command: error.command, responseCode: error.responseCode });
} finally { transporter.close(); }
