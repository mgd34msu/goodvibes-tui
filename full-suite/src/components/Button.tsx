import React, { useState, useCallback } from 'react';

interface ButtonProps {
  label: string;
  onClick?: () => void;
  variant?: 'primary' | 'secondary';
}

export function Button({ label, onClick, variant = 'primary' }: ButtonProps) {
  const [clicked, setClicked] = useState(false);

  const handleClick = useCallback(() => {
    setClicked(true);
    onClick?.();
  }, [onClick]);

  return (
    <div onClick={handleClick} className="p-4 flex items-center">
      <img src="/icon.png" />
      <span>{label}</span>
    </div>
  );
}
