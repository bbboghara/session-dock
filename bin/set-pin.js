// Used by install.sh: reads a PIN from stdin and saves its hash. With --check it
// only says whether the PIN is acceptable. Using stdin keeps the PIN out of `ps`.
import fs from 'node:fs';
import { pinProblem, setPinFile } from '../lib/auth.js';
import { AUTH_FILE, FIRST_PIN_FILE } from '../lib/config.js';

const pin = fs.readFileSync(0, 'utf8').trim();
const problem = pinProblem(pin);
if (problem) {
  console.error(problem);
  process.exit(1);
}
if (process.argv[2] !== '--check') setPinFile(AUTH_FILE, pin, FIRST_PIN_FILE);
