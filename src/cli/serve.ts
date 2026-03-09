#!/usr/bin/env tsx
import 'dotenv/config';
import { loadDriver, type DriverName } from '../drivers/index.js';

const driver = (process.env.COMMS_DRIVER ?? 'telegram') as DriverName;

console.log(`comms: starting driver "${driver}"`);
const d = await loadDriver(driver);
await d.serve();
