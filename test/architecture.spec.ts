import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..', 'src');
const CORE = join(SRC, 'core');

/** core/ so pode depender de si mesmo, de builtins do node e de @opentelemetry/api. */
const ALLOWED_EXTERNAL = [/^node:/, /^@opentelemetry\/api$/];

/**
 * Nomes de cliente, terminal ou orgao. Se um destes aparecer em src/, a
 * configuracao deixou de ser configuracao e virou codigo -- e a promessa de
 * "um artefato, N deployments" cai junto.
 */
// \b em cada ponta: sem isso `attemptsMade` casa com "tsm" e a regra vira
// ruido que alguem desliga na primeira semana.
const CLIENT_NAMES =
  /\b(gts|sao[-_]?luis|parceiro[-_]?x|trizy|tsm|lyin[-_]?s|receita[-_]?federal|recintos)\b/i;

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return tsFiles(full);
      return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [full]
        : [];
    }),
  );
  return files.flat();
}

function importSpecifiers(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    // Pega tambem `require(...)` e `import(...)`, que escapariam da checagem
    // de import estatico.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const first = node.arguments[0];
      if ((isRequire || isDynamicImport) && first !== undefined && ts.isStringLiteral(first)) {
        specifiers.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

describe('fronteiras de modulo', () => {
  /**
   * O dependency-cruiser e o portao real (roda no CI e no pre-push); isto aqui
   * roda dentro do `npm test`, que e onde a violacao e mais barata de descobrir.
   * Duas ferramentas, de proposito: a que o desenvolvedor executa a toda hora e
   * a que nao deixa passar.
   */
  it('core/ nao importa nada de fora de core/', async () => {
    const files = await tsFiles(CORE);
    expect(files.length).toBeGreaterThan(10);

    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const specifier of importSpecifiers(source, file)) {
        const shortFile = relative(SRC, file);

        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier);
          if (!target.startsWith(CORE)) {
            violations.push(`${shortFile}: '${specifier}' sai de core/`);
          }
          continue;
        }

        if (!ALLOWED_EXTERNAL.some((allowed) => allowed.test(specifier))) {
          violations.push(`${shortFile}: dependencia externa proibida '${specifier}'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('nenhum arquivo de src/ menciona nome de cliente, terminal ou orgao', async () => {
    const files = await tsFiles(SRC);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        // A regra vale para codigo, nao para o texto que explica a regra.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
          continue;
        if (CLIENT_NAMES.test(line)) {
          violations.push(`${relative(SRC, file)}:${index + 1}: ${trimmed}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('somente observability/logger.ts importa consola', async () => {
    const files = await tsFiles(SRC);
    const offenders: string[] = [];

    for (const file of files) {
      if (file.endsWith(join('observability', 'logger.ts'))) continue;
      const source = await readFile(file, 'utf8');
      if (importSpecifiers(source, file).includes('consola')) offenders.push(relative(SRC, file));
    }

    // Sem esta regra, o primeiro `consola.error(err)` dentro de um catch
    // qualquer derrota todo o desenho de mascaramento: o erro do undici carrega
    // os headers da requisicao, Authorization incluso.
    expect(offenders).toEqual([]);
  });

  /**
   * `import type` apaga a classe em runtime, e a DI do Nest resolve o parametro
   * pelo metadado design:paramtypes -- que passa a ser undefined. O resultado e
   * um erro de boot, nao de compilacao, e o autofix do Biome (regra
   * useImportType) faz essa conversao SOZINHO.
   *
   * Por isso a regra esta desligada no biome.json e verificada aqui: e uma
   * quebra que nenhum typecheck pega.
   */
  it('nenhum parametro injetado pelo Nest vem de `import type`', async () => {
    const files = await tsFiles(SRC);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      // So classes que o container instancia: as demais sao construidas com `new`.
      if (!/@(Injectable|Controller|Processor)\(/.test(source)) continue;

      const typeOnly = new Set<string>();
      for (const match of source.matchAll(/^import type \{([^}]*)\} from/gm)) {
        for (const raw of (match[1] ?? '').split(',')) {
          const name = raw.trim().split(' as ')[0]?.trim();
          if (name !== undefined && name.length > 0 && /^[A-Z]/.test(name)) typeOnly.add(name);
        }
      }

      for (const ctor of source.matchAll(/constructor\(([\s\S]*?)\)\s*\{/g)) {
        for (const line of (ctor[1] ?? '').split('\n')) {
          // Parametro com @Inject(TOKEN) nao usa design:paramtypes.
          if (line.includes('@Inject')) continue;
          const typeName = /:\s*([A-Z][A-Za-z0-9_]*)/.exec(line)?.[1];
          if (typeName !== undefined && typeOnly.has(typeName)) {
            violations.push(`${relative(SRC, file)}: parametro '${typeName}' importado como type`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('persistence/ nao conhece as camadas acima', async () => {
    const files = await tsFiles(join(SRC, 'persistence'));
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const specifier of importSpecifiers(source, file)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (/\/src\/(http|queue|config)\//.test(target)) {
          violations.push(`${relative(SRC, file)}: '${specifier}'`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
