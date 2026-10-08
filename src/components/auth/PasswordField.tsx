"use client";

import { useState } from "react";

type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  placeholder?: string;
  minLength?: number;
  error?: string | null;
};

export default function PasswordField({ id, label, value, onChange, autoComplete, placeholder, minLength, error }: Props) {
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="field-wrap">
        <input
          id={id}
          type={shown ? "text" : "password"}
          required
          minLength={minLength}
          autoComplete={autoComplete}
          placeholder={placeholder}
          className="field field--with-action"
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="field-wrap__action"
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
            {shown ? <path d="M4 4l16 16" /> : null}
          </svg>
        </button>
      </div>
      {error ? (
        <span className="field-error" id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
