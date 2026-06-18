export default function OrbitLogo({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width={size} height={size} className={className}>
      <circle cx="16" cy="16" r="7" fill="currentColor" />
      <ellipse cx="16" cy="16" rx="13" ry="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" transform="rotate(-25 16 16)" />
      <circle cx="27" cy="12.5" r="1.8" fill="currentColor" transform="rotate(-25 16 16)" />
    </svg>
  );
}
