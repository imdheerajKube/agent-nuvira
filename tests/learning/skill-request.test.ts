import { describe, expect, it } from 'vitest';

import { detectRequestedSkillNames } from '../../src/learning/skill-request.js';

const names = ['rag-pipeline', 'api-design', 'docker-management'];

describe('detectRequestedSkillNames — a direct name request is not a keyword guess', () => {
  it('detects an exact named skill in a request clause', () => {
    expect(detectRequestedSkillNames('please use the rag-pipeline skill', names)).toEqual([
      'rag-pipeline',
    ]);
  });

  it('accepts the spaced spelling of a hyphenated catalog name', () => {
    expect(detectRequestedSkillNames('Use the RAG pipeline skill for this', names)).toEqual([
      'rag-pipeline',
    ]);
  });

  it('detects every named skill in one request', () => {
    expect(
      detectRequestedSkillNames('use the rag-pipeline and api-design skills', names),
    ).toEqual(['rag-pipeline', 'api-design']);
  });

  it('accepts the direct form without the word "skill"', () => {
    expect(detectRequestedSkillNames('please use `api-design` here', names)).toEqual([
      'api-design',
    ]);
  });

  it('does not turn a plain mention into a request', () => {
    expect(detectRequestedSkillNames('what is the rag-pipeline skill?', names)).toEqual([]);
    expect(detectRequestedSkillNames('build a RAG pipeline for documents', names)).toEqual([]);
    expect(detectRequestedSkillNames('the docker-management skill sounds useful', names)).toEqual([]);
  });

  it('honours negation around the name', () => {
    expect(detectRequestedSkillNames("don't use the rag-pipeline skill", names)).toEqual([]);
    expect(detectRequestedSkillNames('use rag-pipeline, not api-design', names)).toEqual([
      'rag-pipeline',
    ]);
    expect(
      detectRequestedSkillNames("don't use the rag-pipeline skill, use api-design", names),
    ).toEqual(['api-design']);
  });

  it('returns nothing when no catalog name was named', () => {
    expect(detectRequestedSkillNames('use a strong retrieval pipeline here', names)).toEqual([]);
  });
});
