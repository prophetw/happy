#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
console.error(JSON.stringify({event:'happy-dot-release-loaded',pid:process.pid,source:'e2327a6170e20effca8ada1ee8cae1b03ee7afd2',sqliteSource:'f31566fa+deployed-sqlite',modules:Object.fromEntries(['hostedDotLifecycle.cjs','hostedDotAuthority.mjs','hostedDotMain.mjs'].map(name=>[name,createHash('sha256').update(readFileSync(new URL('../dist/codex/'+name,import.meta.url))).digest('hex')]))}));
import { main } from '../dist/codex/hostedDotMain.mjs';
main().catch(error => { console.error(error.message); process.exitCode = 1; });
