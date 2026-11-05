// SPDX-License-Identifier: FSL-1.1-ALv2
import { Button as KobalteButton } from "@kobalte/core/button"
import { cva, type VariantProps } from "class-variance-authority"
import { type ParentComponent, splitProps } from "solid-js"
import { cn } from "~/lib/cn"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-sm font-semibold transition-colors duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-foreground border-none hover:bg-accent-hover",
        ghost: "text-text-secondary hover:bg-surface-hover hover:text-text font-medium",
        outline:
          "border border-border bg-transparent text-text-secondary hover:bg-surface-hover hover:border-border-strong hover:text-text font-medium",
        primary:
          "bg-accent-glow border border-accent-border text-accent hover:bg-accent-wash hover:text-accent-hover font-medium",
        danger: "bg-error text-white hover:bg-error/90",
      },
      size: {
        sm: "px-2.5 py-1 text-xs font-medium",
        md: "py-[10px] px-4 text-[13.5px]",
        lg: "h-11 px-6 text-[14px]",
      },
      // Full width is opt-in: a stacked form's submit asks for it. As the md
      // default it stretched every button set in a flex row and squeezed the
      // text beside it to a word per line (Settings > Nodes).
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    // A label-sized md button keeps its width when the row runs short: the
    // text beside it wraps, not the button's label ("Add a / connection").
    compoundVariants: [{ size: "md", fullWidth: false, class: "shrink-0" }],
    defaultVariants: {
      variant: "default",
      size: "md",
      fullWidth: false,
    },
  },
)

interface ButtonProps extends VariantProps<typeof buttonVariants> {
  class?: string
  disabled?: boolean
  loading?: boolean
  type?: "button" | "submit" | "reset"
  onClick?: (e: MouseEvent) => void
}

export const Button: ParentComponent<ButtonProps> = (props) => {
  const [local, others] = splitProps(props, [
    "class",
    "variant",
    "size",
    "fullWidth",
    "loading",
    "children",
    "disabled",
  ])

  return (
    <KobalteButton
      class={cn(
        buttonVariants({ variant: local.variant, size: local.size, fullWidth: local.fullWidth }),
        local.class,
      )}
      disabled={local.disabled || local.loading}
      aria-busy={local.loading || undefined}
      {...others}
    >
      {local.loading ? (
        <span
          data-loading
          class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {local.children}
    </KobalteButton>
  )
}
