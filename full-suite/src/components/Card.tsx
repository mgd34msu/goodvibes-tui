import React from 'react';
import { Button } from './Button.tsx';

interface CardProps {
  title: string;
  children: React.ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <div className="rounded-lg shadow-md p-6 bg-white">
      <h2 className="text-xl font-bold mb-4">{title}</h2>
      <div className="overflow-auto max-h-96">
        {children}
      </div>
      <Button label="Close" variant="secondary" />
    </div>
  );
}
