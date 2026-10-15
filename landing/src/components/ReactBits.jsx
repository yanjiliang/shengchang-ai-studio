// React Bits components (reactbits.dev, MIT) ported for this landing page:
// adapted to `motion`, Chinese text, and the 声场 brand palette.
import { motion, useInView } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

// SplitText — per-character stagger rise. Word-splitting (the original)
// does nothing for Chinese, so this variant splits characters.
export function SplitText({ text, delay = 55, initialDelay = 0.15, className, accent = '', accentColor = 'var(--accent)' }) {
  let charIndex = 0;
  return (
    <span className={className} style={{ display: 'inline-block' }}>
      {[...text].map((char, index) => {
        const isAccent = accent.includes(char);
        const animateDelay = initialDelay + charIndex * (delay / 1000);
        charIndex += 1;
        return (
          <motion.span
            key={index}
            initial={{ opacity: 0, y: 22, rotateX: -50 }}
            animate={{ opacity: 1, y: 0, rotateX: 0 }}
            transition={{ duration: 0.55, delay: animateDelay, ease: [0.22, 1, 0.36, 1] }}
            style={{ display: 'inline-block', transformOrigin: '50% 100%', color: isAccent ? accentColor : undefined }}
          >
            {char}
          </motion.span>
        );
      })}
    </span>
  );
}

// AnimatedContent — reveal on scroll into view (React Bits AnimatedContent).
export function AnimatedContent({ children, distance = 34, delay = 0, once = true, className, as = 'div' }) {
  const Tag = motion[as] || motion.div;
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, filter: 'blur(6px)', y: distance }}
      whileInView={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
      viewport={{ once, amount: 0.25 }}
      transition={{ duration: 0.65, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </Tag>
  );
}

// StarBorder — a light dot travelling around the border (React Bits
// StarBorder). Pure CSS conic animation; see styles.css.
export function StarBorder({ children, className = '', color = 'var(--accent)', ...rest }) {
  return (
    <span className={`star-border ${className}`} style={{ '--star-color': color }} {...rest}>
      <span className="star-border-layer" aria-hidden="true" />
      <span className="star-border-content">{children}</span>
    </span>
  );
}

// SpotlightCard — mouse-following radial highlight (React Bits SpotlightCard).
export function SpotlightCard({ children, className = '', spotlightColor = 'rgb(240 150 60 / 12%)', ...rest }) {
  const ref = useRef(null);
  const onMouseMove = (event) => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty('--spot-x', `${event.clientX - rect.left}px`);
    node.style.setProperty('--spot-y', `${event.clientY - rect.top}px`);
  };
  return (
    <div ref={ref} className={`spotlight-card ${className}`} onMouseMove={onMouseMove} style={{ '--spotlight-color': spotlightColor }} {...rest}>
      {children}
    </div>
  );
}

// CountUp — animates a number when scrolled into view (React Bits CountUp).
export function CountUp({ to, duration = 1.4, suffix = '', className }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!inView) return undefined;
    const startedAt = performance.now();
    let frame;
    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / (duration * 1000));
      setValue(Math.round(to * (1 - Math.pow(1 - progress, 3))));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, to, duration]);
  return <span ref={ref} className={className}>{value}{suffix}</span>;
}

// Aurora — slow drifting gradient blobs behind the hero (React Bits Aurora).
export function Aurora({ className = '' }) {
  return (
    <div className={`aurora ${className}`} aria-hidden="true">
      <div className="aurora-blob a1" />
      <div className="aurora-blob a2" />
      <div className="aurora-blob a3" />
    </div>
  );
}
