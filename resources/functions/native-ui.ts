/** Craft primitives and grouped layouts, matching HQ.training's native UI vocabulary. */
export const nativeUi = {
  screen: 'flex-1 bg-[#f2f4ef] dark:bg-[#101c16]',
  header: 'mx-4 mt-6 mb-2 text-[13px] font-semibold uppercase text-[#51604e] dark:text-[#b0bfac]',
  card: 'mx-4 p-4 rounded-[12px] bg-white dark:bg-[#1b2c22]',
  row: 'flex-row items-center gap-3 py-3 min-h-[44px]',
  title: 'text-[17px] font-semibold text-[#192414] dark:text-[#f0f5ec]',
  body: 'text-[17px] text-[#253321] dark:text-[#e3ecdf]',
  caption: 'text-[13px] text-[#51604e] dark:text-[#b0bfac]',
  input: 'min-h-[44px] rounded-[8px] px-3 py-2 text-[17px] text-[#192414] bg-[#eef2e9] dark:text-white dark:bg-[#314536]',
  action: 'min-h-[48px] rounded-[12px] bg-[#24724b] items-center justify-center px-4',
  actionText: 'text-[17px] font-semibold text-white',
  secondary: 'min-h-[44px] rounded-[12px] bg-[#e7edde] dark:bg-[#314536] items-center justify-center px-3',
  secondaryText: 'text-[15px] font-semibold text-[#253321] dark:text-[#e3ecdf]',
  danger: 'text-[17px] text-[#b4232a] dark:text-[#ff8487]',
} as const
