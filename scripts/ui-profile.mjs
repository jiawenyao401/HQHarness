/** Translate the team's portable data into the existing Harness theme contract. */
export function desktopThemeTokens(profile) {
  if (profile?.id !== 'shadcn-neutral-v3' || profile.version !== 3) throw new Error('Unsupported HQHarness UI profile')
  const result = {}
  const color = (names, key, group = null) => {
    for (const name of names.split(' ')) result[`--dsw-${name}`] = Object.fromEntries(['light', 'dark'].map(mode => [mode, (group ? profile[group][mode] : profile[mode])[key]]))
  }
  color('alias-bg-base alias-bg-document-preview', 'background')
  color('alias-bg-layer-1 alias-bg-overlay alias-button-elevated-fill alias-button-floating-fill specific-input-major specific-login-input', 'card')
  color('alias-bg-layer-2 alias-bg-layer-3 alias-bg-module-platform alias-bg-multi-select alias-bg-skeleton alias-button-primary-dimmed alias-markdown-placeholder specific-selector specific-tip', 'muted')
  color('alias-label-primary alias-label-primary-bluish alias-label-primary-dimmed alias-menu-icon alias-label-document-preview', 'foreground')
  color('alias-label-secondary alias-label-tertiary alias-label-caption alias-label-dimmed', 'muted-foreground')
  color('alias-label-primary-foreground alias-label-primary-inverted alias-brand-primary-invert', 'primary-foreground')
  color('alias-brand-primary alias-brand-text alias-brand-primary-new-colorprimary-new-color alias-state-business-primary alias-button-primary-fill alias-button-contrast-fill alias-link', 'primary')
  color('alias-border-l1 alias-border-l2 alias-border-l2-darkmode-thin alias-border-l3 alias-border-l4 alias-border-inverted alias-border-inverted2 elevation-stroke-color', 'border')
  color('alias-button-ghost-active-border', 'ring')
  color('alias-button-info-fill alias-button-info-hover', 'primary')
  color('alias-state-business-tertiary alias-button-ghost-active-fill specific-bubble specific-bubble-highlight', 'accent')
  color('specific-sidebar-fill', 'sidebar')
  color('specific-sidebar-nav-item-active specific-sidebar-nav-item-active-accent', 'sidebar-accent')
  color('alias-button-primary-hover', 'primaryHover', 'interaction')
  color('alias-interactive-bg-hover alias-interactive-bg-hover-solid alias-button-floating-hover specific-sidebar-nav-item-hover', 'subtleHover', 'interaction')
  color('alias-interactive-bg-active alias-interactive-bg-hover-accent alias-button-ghost-active-hover', 'subtleActive', 'interaction')
  color('alias-bg-mask-1 alias-bg-mask-2 alias-bg-mask-3', 'overlay', 'interaction')
  color('alias-state-error-primary alias-state-error-secondary', 'destructive')
  color('alias-state-success-primary alias-state-success-secondary', 'success', 'semantic')
  color('alias-state-warn-primary alias-state-warn-secondary alias-state-warn-label', 'warning', 'semantic')
  color('alias-ui-control-border', 'input')
  color('alias-ui-focus-ring', 'ring')
  color('alias-ui-primary-active', 'primaryActive', 'interaction')
  color('alias-ui-surface', 'popover')
  color('alias-tooltip-bg alias-toast-bg', 'popover')
  color('alias-toast-label', 'popover-foreground')
  color('alias-ui-hover-border', 'controlHoverBorder', 'interaction')
  const fixed = {
    '--dsw-font-family': profile.typography.families.ui,
    '--dsw-font-family-brand': profile.typography.families.ui,
    '--ds-font-family-code': profile.typography.families.mono,
    '--dsw-radius-xs': profile.radii.small,
    '--dsw-radius-sm': profile.radii.control,
    '--dsw-radius-md': profile.radii.control,
    '--dsw-radius-lg': profile.radii.surface,
    '--dsw-radius-xl': profile.radii.panel,
    '--dsw-radius-panel': profile.radii.panel,
    '--dsw-alias-ui-control-height': profile.density.standard.controlMinHeight,
    '--dsw-alias-ui-control-compact-height': profile.density.compact.controlMinHeight,
    '--dsw-alias-ui-control-padding': profile.density.standard.controlPaddingInline,
    '--dsw-alias-ui-control-gap': profile.layout.inlineGap,
    '--dsw-menu-backdrop-filter': 'none'
  }
  for (const [name, value] of Object.entries(fixed)) result[name] = { light:value, dark:value }
  for (const name of ['--dsw-specific-menu', '--dsw-menu-surface-fill', '--dsw-alias-menu-group-header-fill']) result[name] = { light:profile.light.popover, dark:profile.dark.popover }
  for (const [name, role] of Object.entries({ '--dsw-shadow-lv1':'none', '--dsw-shadow-lv1-blur':'none', '--dsw-shadow-lv2':'popover', '--dsw-shadow-lv3':'modal', '--dsw-alias-ui-popover-shadow':'popover', '--dsw-alias-ui-modal-shadow':'modal' })) result[name] = { light:profile.elevation.light[role], dark:profile.elevation.dark[role] }
  return result
}
