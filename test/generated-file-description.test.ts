import assert from 'node:assert/strict';
import test from 'node:test';

import { generatedFileDescription } from '../src/presentation/views/generated-file-description';

test('a generated file checked by hand says it was included manually', () => {
  assert.equal(generatedFileDescription(true), 'generated · included manually');
  assert.equal(
    generatedFileDescription(false),
    'generated · left out of bulk selection'
  );
});
