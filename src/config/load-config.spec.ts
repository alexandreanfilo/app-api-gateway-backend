import { join } from 'node:path';
import { StaticSecretResolver } from '../../test/fakes/in-memory-stores';
import { ConfigError, formatConfigError } from './config-error';
import { loadGatewayConfig } from './load-config';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'pipelines');

const ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/gateway',
} as NodeJS.ProcessEnv;

/**
 * Segredos das FIXTURES sinteticas. Os testes de configuracao nao apontam para
 * nenhum fluxo de producao: um YAML real muda por motivo de negocio e derrubaria
 * testes que so deveriam falar sobre o carregador.
 */
const SECRETS = new StaticSecretResolver({
  ORIGEM_USUARIO: 'usuario',
  ORIGEM_SENHA: 'senha',
  DESTINO_A_TOKEN: 'token-a',
  RECEPCAO_API_KEY: 'chave',
  DESTINO_B_TOKEN: 'token-b',
  PARCEIRO_TOKEN: 'chave',
  TOKEN_A: 'a',
  TOKEN_B: 'b',
});

async function loadFixture(name: string): Promise<ConfigError> {
  try {
    await loadGatewayConfig({ dir: join(FIXTURES, name), secrets: SECRETS, env: ENV });
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error(`esperava ConfigError para a fixture '${name}', mas o boot passou`);
}

describe('loadGatewayConfig', () => {
  it('carrega as duas fixtures e compila cada tipo de entrada', async () => {
    const config = await loadGatewayConfig({
      dir: join(FIXTURES, 'valid'),
      secrets: SECRETS,
      env: ENV,
    });

    expect(config.pipelines).toHaveLength(2);
    expect(config.pipelines.map((p) => p.source.kind).sort()).toEqual([
      'http-endpoint',
      'http-poll',
    ]);
  });

  describe('credencial em texto puro', () => {
    it('rejeita string crua em campo de segredo, apontando arquivo e caminho', async () => {
      const error = await loadFixture('raw-password');

      expect(error.issues).toEqual([
        {
          file: 'origem-com-senha.yaml',
          path: 'source.auth.body.senha',
          message: 'esperado { secret: REF } -- segredo em texto puro nao e permitido',
        },
      ]);
    });

    // A mensagem de erro e interface de usuario: e o que alguem le as 3h da
    // manha. Se nao estiver sob teste de string exata, ela apodrece.
    it('formata a saida de stderr exatamente como o operador a le', async () => {
      const error = await loadFixture('raw-password');

      expect(formatConfigError(error)).toBe(
        [
          'Configuracao invalida (1 erro(s) em 1 arquivo(s)):',
          '',
          '  origem-com-senha.yaml: source.auth.body.senha: esperado { secret: REF } -- segredo em texto puro nao e permitido',
          '',
          'Nenhum pipeline foi iniciado.',
        ].join('\n'),
      );
    });
  });

  it('rejeita campo de poll dentro de um http-endpoint', async () => {
    const error = await loadFixture('poll-field-in-endpoint');

    const paths = error.issues.map((i) => i.path);
    expect(paths).toContain('source');
    const message = error.issues.map((i) => i.message).join(' | ');
    expect(message).toContain('schedule');
    expect(message).toContain('pagination');
  });

  it('derruba o boot quando dois pipelines declaram o mesmo path', async () => {
    const error = await loadFixture('duplicate-path');

    expect(error.issues).toContainEqual({
      file: 'b-segundo.yaml',
      path: 'source.path',
      // A normalizacao precisa enxergar `eventos` e `/in/eventos` como a MESMA
      // rota; senao a colisao so apareceria em producao, como 404 intermitente.
      message: "path '/in/eventos' ja declarado em a-primeiro.yaml",
    });
  });

  it('derruba o boot quando um segredo referenciado nao existe no ambiente', async () => {
    const error = await loadFixture('missing-secret');

    expect(error.issues).toEqual([
      {
        file: 'pipeline.yaml',
        path: 'source.auth.value',
        message: "segredo 'NAO_EXISTE_NO_AMBIENTE' nao encontrado em segredos de teste",
      },
    ]);
  });

  describe('avisos que nao derrubam o boot', () => {
    it('avisa quando dois pipelines consultam a mesma origem e entregam no mesmo destino', async () => {
      const config = await loadGatewayConfig({
        dir: join(FIXTURES, 'origem-duplicada'),
        secrets: new StaticSecretResolver({ TOKEN_A: 'a', TOKEN_B: 'b' }),
        env: ENV,
      });

      // Sobe -- ha caso legitimo de mesma origem com filtros diferentes --, mas
      // com origem E destino iguais e quase sempre um arquivo esquecido, e sem
      // aviso isso so aparece como entrega em dobro do outro lado.
      expect(config.pipelines).toHaveLength(2);
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain("'segundo'");
      expect(config.warnings[0]).toContain("'primeiro'");
      expect(config.warnings[0]).toContain('duas vezes');
    });

    it('nao avisa quando os exemplos validos convivem', async () => {
      const config = await loadGatewayConfig({
        dir: join(FIXTURES, 'valid'),
        secrets: SECRETS,
        env: ENV,
      });
      expect(config.warnings).toEqual([]);
    });
  });

  describe('enabled: false torna o arquivo inerte', () => {
    /**
     * Sem isto, `enabled: false` inverte de sentido: quando o contrato de um
     * cliente termina e o token sai do ambiente, desabilitar o fluxo seria a
     * forma de para-lo -- e em vez disso o gateway inteiro deixa de subir,
     * derrubando todos os outros clientes junto.
     */
    it('nao exige os segredos de um pipeline desabilitado', async () => {
      const config = await loadGatewayConfig({
        dir: join(FIXTURES, 'desabilitado'),
        secrets: new StaticSecretResolver({
          RECEPCAO_API_KEY: 'chave',
          DESTINO_B_TOKEN: 'token',
        }),
        env: ENV,
      });

      expect(config.pipelines.map((p) => p.id)).toEqual(['recepcao-eventos']);
    });

    it('nao deixa um pipeline desabilitado colidir de rota com um ativo', async () => {
      // Desabilitado nao registra rota, entao a colisao nao existe de fato.
      const config = await loadGatewayConfig({
        dir: join(FIXTURES, 'desabilitado'),
        secrets: new StaticSecretResolver({
          RECEPCAO_API_KEY: 'chave',
          DESTINO_B_TOKEN: 'token',
        }),
        env: ENV,
      });
      expect(config.pipelines).toHaveLength(1);
    });
  });

  it('nao materializa o valor de nenhum segredo durante o boot', async () => {
    const resolved: string[] = [];
    const spy = new StaticSecretResolver({
      ORIGEM_USUARIO: 'u',
      ORIGEM_SENHA: 'p',
      DESTINO_A_TOKEN: 't',
      RECEPCAO_API_KEY: 'k',
      DESTINO_B_TOKEN: 'b',
    });
    const original = spy.resolve.bind(spy);
    spy.resolve = async (name: string) => {
      resolved.push(name);
      return original(name);
    };

    await loadGatewayConfig({ dir: join(FIXTURES, 'valid'), secrets: spy, env: ENV });

    // Apenas exists() no boot: resolver tudo encheria o heap de credenciais em
    // texto puro por horas (visiveis em heap dump) e mataria rotacao.
    expect(resolved).toEqual([]);
  });
});
