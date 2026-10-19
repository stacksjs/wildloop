import { nativeUi as grouped } from '@stacksjs/stx/native/ui'

/**
 * The native screens' vocabulary: stx's grouped vocabulary, in role classes,
 * so its colours come from the role answers in config/crosswind.ts like the
 * shared components' do.
 *
 * What is added here is what a Craft `<Button>` needs. A Button is one leaf -
 * its box and its words are the same node - so a button entry carries both
 * halves of the shared vocabulary's button, where a hand-built button is a
 * View holding a Text.
 */
export const nativeUi = {
  ...grouped,
  /** The filled button at the end of a flow. */
  action: `${grouped.primaryButton} ${grouped.primaryButtonText}`,
  actionText: grouped.primaryButtonText,
  /** A quieter button beside it. */
  secondary: `${grouped.secondaryButton} ${grouped.secondaryButtonText}`,
  secondaryText: grouped.secondaryButtonText,
  /** A button floating over a map or a photograph. */
  floating: `${grouped.floatingButton} ${grouped.secondaryButtonText}`,
  /** Something that went wrong, said at reading size. */
  danger: `text-[17px] ${grouped.destructive}`,
  /**
   * A sign-in screen's heading. The four auth screens are one flow — a
   * viewer walks Login -> Register -> ForgotPassword without the app around
   * them, since those screens carry no tab bar, no back chevron and no edge
   * swipe — so they share one size and one alignment.
   */
  authTitle: `text-center ${grouped.heading}`,
} as const
