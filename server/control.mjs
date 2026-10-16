import fs from 'node:fs';
import { api } from './client.mjs';
const [method = 'doctor', input] = process.argv.slice(2);
let params = {};
if (input) params = JSON.parse(input.startsWith('@') ? fs.readFileSync(input.slice(1), 'utf8') : input);
try { console.log(JSON.stringify(await api(method, params), null, 2)); }
catch (error) { console.error(JSON.stringify({ error: error.message, code: error.code })); process.exitCode = 1; }
