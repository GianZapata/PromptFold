import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SettingWriteTarget,
  settingWriteTarget
} from '../src/domain/services/setting-write.service';

test('a format change stays in user settings until the workspace already has a value', () => {
  assert.equal(settingWriteTarget(undefined), SettingWriteTarget.Global);
  assert.equal(
    settingWriteTarget({ globalValue: 'xml' }),
    SettingWriteTarget.Global
  );
  assert.equal(
    settingWriteTarget({ workspaceValue: 'markdown' }),
    SettingWriteTarget.Workspace
  );
});
