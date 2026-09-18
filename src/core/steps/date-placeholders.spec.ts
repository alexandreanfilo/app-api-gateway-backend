import { resolveDatePlaceholders, resolveQueryPlaceholders } from './date-placeholders';

const TZ = 'America/Sao_Paulo';

describe('resolveDatePlaceholders', () => {
  // 17/09/2026 as 10h em Brasilia (13h UTC).
  const meioDia = new Date('2026-09-17T13:00:00Z');

  it('resolve {today} no formato YYYY-MM-DD', () => {
    expect(resolveDatePlaceholders('{today}', meioDia, TZ)).toBe('2026-09-17');
  });

  it('resolve deslocamentos em dias', () => {
    expect(resolveDatePlaceholders('{today-2d}', meioDia, TZ)).toBe('2026-09-15');
    expect(resolveDatePlaceholders('{today+2d}', meioDia, TZ)).toBe('2026-09-19');
  });

  /**
   * O caso que so aparece em producao, e so parte do dia: as 22h em Brasilia ja
   * e dia 18 em UTC. Um pipeline resolvendo em UTC consultaria a data errada
   * todo fim de noite -- e funcionaria perfeitamente no resto do dia.
   */
  it('usa a data do FUSO, nao a de UTC, perto da virada do dia', () => {
    const vinteEDuasHorasBrasilia = new Date('2026-09-18T01:00:00Z');

    expect(resolveDatePlaceholders('{today}', vinteEDuasHorasBrasilia, TZ)).toBe('2026-09-17');
    expect(resolveDatePlaceholders('{today}', vinteEDuasHorasBrasilia, 'UTC')).toBe('2026-09-18');
  });

  it('atravessa virada de mes e de ano', () => {
    expect(resolveDatePlaceholders('{today+1d}', new Date('2026-12-31T13:00:00Z'), TZ)).toBe(
      '2027-01-01',
    );
    expect(resolveDatePlaceholders('{today-1d}', new Date('2026-03-01T13:00:00Z'), TZ)).toBe(
      '2026-02-28',
    );
  });

  it('deixa intacta a string sem placeholder', () => {
    expect(resolveDatePlaceholders('valor-fixo', meioDia, TZ)).toBe('valor-fixo');
  });

  it('resolve a query inteira do exemplo do GTS', () => {
    const query = {
      data_inicial_agendamento: '{today-2d}',
      data_final_agendamento: '{today+2d}',
      terminal: 'SAO-LUIS',
    };

    expect(resolveQueryPlaceholders(query, meioDia, TZ)).toEqual({
      data_inicial_agendamento: '2026-09-15',
      data_final_agendamento: '2026-09-19',
      terminal: 'SAO-LUIS',
    });
  });
});
