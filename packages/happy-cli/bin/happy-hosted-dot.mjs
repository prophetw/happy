#!/usr/bin/env node
import { main } from '../dist/codex/hostedDotMain.mjs';
main().catch(error => { console.error(error.message); process.exitCode = 1; });
