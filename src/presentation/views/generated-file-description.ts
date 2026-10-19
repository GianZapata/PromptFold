export const generatedFileDescription = (checkedByHand: boolean) =>
  checkedByHand
    ? 'generated · included manually'
    : 'generated · left out of bulk selection';
