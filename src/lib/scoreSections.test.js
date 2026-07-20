import { describe, it, expect } from 'vitest';
import { buildSections } from './scoreSections.js';

function band(i) { return { center: i * 100, rowMin: i * 100 - 10, rowMax: i * 100 + 10 }; }

describe('buildSections', () => {
  it('returns a single whole-piece "Score" section when no boundaries are found', () => {
    const systemBands = [band(0), band(1), band(2)];
    const measuresPerSystem = [4, 3, 5];
    const sections = buildSections({
      boundaries: [], systemBands, measuresPerSystem, defaultBeatsPerMeasure: 4, defaultBpm: 100,
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      name: 'Score', tempoMarking: null, startSystemIndex: 0, endSystemIndex: 2,
      beatsPerMeasure: 4, bpm: 100,
    });
    expect(sections[0].systemBands).toEqual(systemBands);
    expect(sections[0].measuresPerSystem).toEqual(measuresPerSystem);
  });

  it('splits into named sections at each boundary, slicing systemBands/measuresPerSystem', () => {
    // Mirrors the real Juggling Clowns shape at a smaller scale: a 3-system
    // "Score" opening, then two named parts of 2 systems each.
    const systemBands = [0, 1, 2, 3, 4, 5, 6].map(band);
    const measuresPerSystem = [4, 3, 5, 6, 2, 6, 2];
    const boundaries = [
      { systemIndex: 3, name: 'Clarinet in B 1', tempoMarking: 'Andante' },
      { systemIndex: 5, name: 'Clarinet in B 2', tempoMarking: 'Andante' },
    ];
    const sections = buildSections({
      boundaries, systemBands, measuresPerSystem, defaultBeatsPerMeasure: 4, defaultBpm: 100,
    });
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({ name: 'Score', startSystemIndex: 0, endSystemIndex: 2 });
    expect(sections[1]).toMatchObject({
      name: 'Clarinet in B 1', tempoMarking: 'Andante', startSystemIndex: 3, endSystemIndex: 4,
    });
    expect(sections[2]).toMatchObject({
      name: 'Clarinet in B 2', tempoMarking: 'Andante', startSystemIndex: 5, endSystemIndex: 6,
    });
    expect(sections[1].measuresPerSystem).toEqual([6, 2]);
    expect(sections[2].systemBands).toEqual([band(5), band(6)]);
  });

  it('uses the boundary name at system 0 instead of the default "Score"', () => {
    const systemBands = [band(0), band(1)];
    const measuresPerSystem = [4, 4];
    const boundaries = [{ systemIndex: 0, name: 'Clarinet in B 1', tempoMarking: 'Andante' }];
    const sections = buildSections({
      boundaries, systemBands, measuresPerSystem, defaultBeatsPerMeasure: 4, defaultBpm: 100,
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('Clarinet in B 1');
  });

  it('ignores an out-of-range boundary index defensively', () => {
    const systemBands = [band(0), band(1)];
    const measuresPerSystem = [4, 4];
    const boundaries = [{ systemIndex: 99, name: 'Bogus' }];
    const sections = buildSections({
      boundaries, systemBands, measuresPerSystem, defaultBeatsPerMeasure: 4, defaultBpm: 100,
    });
    expect(sections).toHaveLength(1);
    expect(sections[0].name).toBe('Score');
  });

  it('returns an empty list for an empty score', () => {
    expect(buildSections({
      boundaries: [], systemBands: [], measuresPerSystem: [], defaultBeatsPerMeasure: 4, defaultBpm: 100,
    })).toEqual([]);
  });
});
