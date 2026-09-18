import { Secret } from '../types/secret';
import { maskBody, maskError, maskHeaders, maskUrl } from './mask';
import { SecretRegistry } from './secret-registry';

describe('maskHeaders', () => {
  it('mascara Bearer preservando o esquema', () => {
    const masked = maskHeaders({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc' });

    expect(masked.authorization).toMatch(/^Bearer \*\*\*\[[0-9a-f]{8}\]$/);
    expect(masked.authorization).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  /**
   * O erro classico: mascarar so o que vem depois dos dois-pontos. O base64 do
   * Basic codifica `usuario:senha` JUNTO, entao qualquer pedaco dele revela a
   * senha inteira -- tem que ir todo.
   */
  it('mascara o Basic INTEIRO, porque o base64 embute a senha', () => {
    const credential = Buffer.from('admin:senha-secreta', 'utf8').toString('base64');
    const masked = maskHeaders({ authorization: `Basic ${credential}` });

    expect(masked.authorization).not.toContain(credential);
    expect(Buffer.from(masked.authorization ?? '', 'utf8').toString()).not.toContain(
      'senha-secreta',
    );
  });

  it.each(['x-api-key', 'x-auth-token', 'cookie', 'set-cookie', 'proxy-authorization'])(
    'mascara o header %s por inteiro',
    (header) => {
      const masked = maskHeaders({ [header]: 'valor-sensivel-12345' });
      expect(masked[header]).not.toContain('valor-sensivel');
    },
  );

  it('preserva headers inocentes, que sao o que serve para diagnostico', () => {
    const masked = maskHeaders({ 'content-type': 'application/json', 'x-request-id': 'req-42' });
    expect(masked['content-type']).toBe('application/json');
    expect(masked['x-request-id']).toBe('req-42');
  });
});

describe('maskUrl', () => {
  it.each(['token', 'access_token', 'api_key', 'password', 'sig', 'signature'])(
    'mascara o parametro de query %s',
    (param) => {
      const masked = maskUrl(`https://api.parceiro/recurso?${param}=VALOR-SECRETO&pagina=2`);
      expect(masked).not.toContain('VALOR-SECRETO');
      // O resto sobrevive: sem isso a URL mascarada perde o valor diagnostico.
      expect(masked).toContain('pagina=2');
    },
  );

  /** Quase sempre esquecido: nao parece header nem campo, e carrega a senha. */
  it('zera o userinfo embutido na URL', () => {
    const masked = maskUrl('https://usuario:senha-secreta@api.parceiro/recurso');

    expect(masked).not.toContain('senha-secreta');
    expect(masked).not.toContain('usuario:');
  });

  it('nao quebra com URL malformada', () => {
    expect(maskUrl('nao-e-uma-url')).toBe('nao-e-uma-url');
  });
});

describe('maskBody', () => {
  it('mascara por nome de chave, em qualquer profundidade', () => {
    const masked = maskBody({
      usuario: 'joao',
      credenciais: { password: 'p4ssw0rd', client_secret: 'cs-123' },
    });

    const serialized = JSON.stringify(masked);
    expect(serialized).not.toContain('p4ssw0rd');
    expect(serialized).not.toContain('cs-123');
    expect(serialized).toContain('joao');
  });

  it('reconhece Secret em qualquer posicao', () => {
    const masked = maskBody({ header: new Secret('TSM_BEARER', 'valor-real') });
    expect(JSON.stringify(masked)).toContain('[secret:TSM_BEARER]');
    expect(JSON.stringify(masked)).not.toContain('valor-real');
  });
});

describe('maskError', () => {
  /**
   * `{ ...err }` produz um objeto VAZIO: message e stack de um Error nao sao
   * enumeraveis. Um logger que faz spread perde exatamente a informacao pela
   * qual foi escrito.
   */
  it('preserva name, message e stack, que o spread perderia', () => {
    const masked = maskError(new Error('falhou feio'));

    expect(masked.name).toBe('Error');
    expect(masked.message).toBe('falhou feio');
    expect(masked.stack).toBeDefined();
    expect({ ...new Error('falhou feio') }).toEqual({});
  });

  it('desce pela cadeia de cause, onde o undici guarda o erro real', () => {
    const cause = new Error('ECONNREFUSED');
    const masked = maskError(new Error('fetch failed', { cause }));

    expect(masked.cause?.message).toBe('ECONNREFUSED');
  });

  it('nao explode com cause circular', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;

    expect(() => maskError(b)).not.toThrow();
  });
});

describe('SecretRegistry (scrubbing por valor)', () => {
  /**
   * A rede de seguranca. Mascarar por nome de chave nao pega uma URL montada
   * por template string nem uma mensagem de erro do parceiro que ecoa o token
   * de volta -- e e sempre por um desses caminhos que o vazamento acontece.
   */
  it('remove o valor de um segredo mesmo onde nenhuma chave o denuncia', () => {
    const registry = new SecretRegistry();
    registry.remember('tok-super-secreto-123');

    const masked = maskUrl('https://api.parceiro/x?campo_inocente=tok-super-secreto-123', registry);

    expect(masked).not.toContain('tok-super-secreto-123');
    expect(masked).toContain('***[');
  });

  it('remove o segredo ecoado pelo destino dentro de uma mensagem de erro', () => {
    const registry = new SecretRegistry();
    registry.remember('tok-super-secreto-123');

    const masked = maskError(new Error('destino recusou o token tok-super-secreto-123'), registry);

    expect(masked.message).not.toContain('tok-super-secreto-123');
  });

  it('ignora valores curtos, para nao casar substring comum', () => {
    const registry = new SecretRegistry();
    registry.remember('admin');

    expect(registry.size).toBe(0);
    expect(registry.scrub('o administrador chegou')).toBe('o administrador chegou');
  });
});

describe('Secret', () => {
  const secret = new Secret('TSM_BEARER', 'valor-real-do-token');

  it.each([
    ['JSON.stringify', () => JSON.stringify({ token: secret })],
    ['template string', () => `Bearer ${secret}`],
    ['String()', () => String(secret)],
  ])('nao vaza o valor via %s', (_name, produce) => {
    expect(produce()).not.toContain('valor-real-do-token');
    expect(produce()).toContain('[secret:TSM_BEARER]');
  });

  it('so entrega o valor por expose(), que e grepavel em code review', () => {
    expect(secret.expose()).toBe('valor-real-do-token');
  });

  it('da um fingerprint estavel para correlacionar sem escrever o segredo', () => {
    expect(secret.fingerprint()).toMatch(/^[0-9a-f]{8}$/);
    expect(new Secret('OUTRO_NOME', 'valor-real-do-token').fingerprint()).toBe(
      secret.fingerprint(),
    );
  });
});
