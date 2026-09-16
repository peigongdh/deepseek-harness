/** A two-line request preview with an explicit full-text disclosure. */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TrajectoryTranslate } from './locales.ts'
import css from './EnhancedTrajectoryView.module.css'

/**
 * Keep long requests from displacing the trajectory on initial navigation.
 * @param props - Original request text and localized disclosure labels.
 * @returns Request preview and, only when needed, its disclosure button.
 */
export function EnhancedRequestHeading({ title, t }: { title: string; t: TrajectoryTranslate }) {
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const text = useRef<HTMLParagraphElement>(null)
  const id = useId()
  useLayoutEffect(() => {
    const element = text.current
    if (element === null) return
    const measure = () => { setOverflow(element.scrollHeight > Number.parseFloat(getComputedStyle(element).lineHeight) * 2 + 1) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [title])
  return <div className={css.requestHeading}>
    <p ref={text} id={id} data-request-preview="" data-expanded={expanded} className={css.requestPreview}>{title}</p>
    {overflow && <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={id}
      onClick={() => { setExpanded(value => !value) }}>{t(expanded ? 'enhanced.collapseRequest' : 'enhanced.expandRequest')}</Button>}
  </div>
}
