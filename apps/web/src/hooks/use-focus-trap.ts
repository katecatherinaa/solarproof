import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // Filter out elements that are not visible.
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) {
      return false;
    }
    return true;
  });
}

export interface UseFocusTrapOptions {
  /** Whether the trap is currently active. Defaults to true. */
  active?: boolean;
  /** Called when Escape is pressed while the trap is active. */
  onClose?: () => void;
  /** Optional ref to the element that should receive initial focus (e.g. heading). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Whether to restore focus to the trigger element on unmount. Defaults to true. */
  restoreFocus?: boolean;
}

/**
 * Traps keyboard focus inside the referenced container while active.
 *
 * - Captures the currently focused element (the trigger) on mount.
 * - Moves initial focus to `initialFocusRef` (e.g. the dialog heading) or the
 *   first interactive element inside the container.
 * - Traps Tab / Shift+Tab within the container.
 * - Calls `onClose` when Escape is pressed.
 * - Restores focus to the trigger element on unmount.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(
  containerRef: RefObject<T | null>,
  options: UseFocusTrapOptions = {},
): void {
  const { active = true, onClose, initialFocusRef, restoreFocus = true } = options;

  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const initialFocusRefRef = useRef(initialFocusRef);

  // Keep latest callbacks/refs without re-running the effect.
  useEffect(() => {
    onCloseRef.current = onClose;
    initialFocusRefRef.current = initialFocusRef;
  }, [onClose, initialFocusRef]);

  useEffect(() => {
    if (!active) return;

    const container = containerRef.current;
    if (!container) return;

    // Capture the trigger element (whatever had focus before the modal opened).
    triggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Move initial focus.
    const focusInitial = () => {
      const preferred = initialFocusRefRef.current?.current;
      if (preferred) {
        preferred.focus();
        return;
      }
      const focusable = getFocusableElements(container);
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        // Fall back to focusing the container itself.
        if (!container.hasAttribute('tabindex')) {
          container.setAttribute('tabindex', '-1');
        }
        container.focus();
      }
    };

    // Defer to allow the dialog to render fully.
    const raf = window.requestAnimationFrame(focusInitial);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (onCloseRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (activeEl === first || activeEl === container || !container.contains(activeEl)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || activeEl === container || !container.contains(activeEl)) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    // Also handle focus escaping the container (e.g. via mouse or programmatic focus).
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (target && !container.contains(target)) {
        const focusable = getFocusableElements(container);
        if (focusable.length > 0) {
          focusable[0].focus();
        } else {
          container.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);

    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);

      if (restoreFocus) {
        const trigger = triggerRef.current;
        triggerRef.current = null;
        if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) {
          trigger.focus();
        }
      }
    };
  }, [active, containerRef, restoreFocus]);
}

export interface DialogA11yProps {
  role: 'dialog';
  'aria-modal': true;
  'aria-labelledby'?: string;
  'aria-label'?: string;
  tabIndex: -1;
}

/**
 * Returns the ARIA attributes required to make a container behave as an
 * accessible modal dialog. Wire the result onto the dialog container element.
 *
 * @param titleId - id of the element that provides the dialog title (heading).
 * @param label - fallback accessible name if no title element exists.
 */
export function getDialogA11yProps(titleId?: string, label?: string): DialogA11yProps {
  const props: DialogA11yProps = {
    role: 'dialog',
    'aria-modal': true,
    tabIndex: -1,
  };
  if (titleId) {
    props['aria-labelledby'] = titleId;
  } else if (label) {
    props['aria-label'] = label;
  }
  return props;
}