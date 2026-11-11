// Offline source integration build. Does not invoke Happy, Relay, native models or postinstall.
// The release build remains `pnpm --filter happy build` (pkgroll exports).
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const output = resolve(process.argv[2] ?? '.hosted-lifecycle-test');
mkdirSync(output, { recursive: true });
for (const name of ['hostedDotState', 'hostedDotLifecycle', 'hostedDotAuthority', 'hostedDotAuthorityPublisher']) {
  const source = readFileSync(new URL('../src/codex/' + name + '.ts', import.meta.url), 'utf8');
  const result = ts.transpileModule(source, { fileName: name+'.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
  if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, { getCanonicalFileName: f=>f, getCurrentDirectory:()=>process.cwd(), getNewLine:()=> '\n' }));
  const code = result.outputText.replace(/require\(["']zod["']\)/g, 'require('+JSON.stringify(require.resolve('zod'))+')')
    .replace(/require\(["']\.\/(hostedDot\w+)["']\)/g, 'require("./$1.cjs")');
  writeFileSync(join(output, name + '.cjs'), code);
}
console.log(output);
