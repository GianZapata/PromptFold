export const SettingWriteTarget = {
  Workspace: 'workspace',
  Global: 'global'
} as const;

export type SettingWriteTarget =
  (typeof SettingWriteTarget)[keyof typeof SettingWriteTarget];

export interface SettingInspection {
  workspaceValue?: unknown;
  globalValue?: unknown;
}

export const settingWriteTarget = (
  inspection: SettingInspection | undefined
): SettingWriteTarget => {
  if (inspection?.workspaceValue !== undefined)
    return SettingWriteTarget.Workspace;

  return SettingWriteTarget.Global;
};
