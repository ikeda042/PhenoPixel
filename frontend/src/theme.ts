import { createSystem, defaultConfig, defineConfig, defineRecipe, defineSemanticTokens, defineSlotRecipe } from '@chakra-ui/react'

const appFont = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif'

// Use the same size scale for buttons, inputs, and native selects.
const controlSizes = {
  xs: { height: '30px', fontSize: '12px' },
  sm: { height: '32px', fontSize: '13px' },
  md: { height: '36px', fontSize: '14px' },
} as const

const semanticColors = defineSemanticTokens.colors({
  gray: {
    fg: { value: 'var(--app-fg)' },
    solid: { value: 'var(--app-fg)' },
    contrast: { value: 'var(--app-bg)' },
    subtle: { value: 'var(--app-surface)' },
    muted: { value: 'var(--app-border)' },
    emphasized: { value: 'var(--app-border-strong)' },
    border: { value: 'var(--app-border-strong)' },
    focusRing: { value: 'var(--app-link)' },
  },
  ink: {
    900: { value: 'var(--app-fg)' },
    800: { value: 'var(--app-fg)' },
    700: { value: 'var(--app-muted)' },
  },
  sand: {
    50: { value: 'var(--app-bg)' },
    100: { value: 'var(--app-surface)' },
    200: { value: 'var(--app-border)' },
    300: { value: 'var(--app-border-strong)' },
  },
  tide: {
    300: { value: 'var(--app-link)' },
    400: { value: 'var(--app-link)' },
    500: { value: 'var(--app-action)' },
    600: { value: 'var(--app-action-hover)' },
    fg: { value: 'var(--app-link)' },
    solid: { value: 'var(--app-action)' },
    contrast: { value: '#fff' },
    subtle: { value: 'var(--app-selection)' },
    muted: { value: 'var(--app-selection)' },
    emphasized: { value: 'var(--app-border-strong)' },
    border: { value: 'var(--app-border-strong)' },
    focusRing: { value: 'var(--app-link)' },
  },
  violet: {
    300: { value: 'var(--app-error)' },
    400: { value: 'var(--app-error)' },
    500: { value: 'var(--app-error)' },
    600: { value: 'var(--app-error)' },
  },
})

const customConfig = defineConfig({
  theme: {
    tokens: {
      fonts: {
        heading: { value: appFont },
        body: { value: appFont },
      },
      radii: {
        xs: { value: '2px' },
        sm: { value: '3px' },
        md: { value: '3px' },
        lg: { value: '3px' },
        xl: { value: '3px' },
        '2xl': { value: '4px' },
        '3xl': { value: '4px' },
      },
    },
    semanticTokens: { colors: semanticColors },
    recipes: {
      button: defineRecipe({
        base: { fontWeight: '500', borderRadius: '3px', boxShadow: 'none' },
        variants: {
          variant: { outline: { bg: 'sand.50' } },
          size: Object.fromEntries(
            Object.entries(controlSizes).map(([size, { height, fontSize }]) => [
              size,
              { h: height, minW: height, fontSize, gap: size === 'md' ? '8px' : '6px' },
            ]),
          ),
        },
        defaultVariants: { variant: 'outline' },
      }),
      input: {
        base: { borderRadius: '3px', minH: 'var(--input-height)' },
        variants: {
          size: Object.fromEntries(
            Object.entries(controlSizes).map(([size, { height, fontSize }]) => [
              size,
              { '--input-height': height, fontSize },
            ]),
          ),
          variant: {
            outline: {
              bg: 'sand.50',
              borderColor: 'sand.300',
              _placeholder: { color: 'ink.700' },
            },
          },
        },
      },
    },
    slotRecipes: {
      nativeSelect: defineSlotRecipe({
        slots: ['root', 'field', 'indicator'],
        base: {
          field: { borderRadius: '3px', minH: 'var(--select-field-height)' },
        },
        variants: {
          size: Object.fromEntries(
            Object.entries(controlSizes).map(([size, { height, fontSize }]) => [
              size,
              {
                root: { '--select-field-height': height },
                field: { fontSize },
              },
            ]),
          ),
        },
      }),
    },
  },
  globalCss: {
    body: { bg: 'sand.50', color: 'ink.900', fontFamily: 'body', fontSize: '14px' },
  },
})

export default createSystem(defaultConfig, customConfig)
