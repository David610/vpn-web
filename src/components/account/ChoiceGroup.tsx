"use client";

export type Choice<T extends string> = {
  value: T;
  title: string;
  text: string;
  disabled?: boolean;
  note?: string;
};

/**
 * A group of radio options, drawn either as side-by-side cards (create) or as
 * a plain list (edit). Real radio inputs, so keyboard and screen readers work.
 */
export default function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  variant,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: Choice<T>[];
  variant: "cards" | "list";
}) {
  return (
    <fieldset className={`choices choices--${variant}`}>
      <legend>{legend}</legend>
      <div className="choices__grid">
        {options.map((option) => (
          <label
            key={option.value}
            className={`choice${value === option.value ? " is-on" : ""}${option.disabled ? " is-disabled" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="choice__dot" aria-hidden="true" />
            <span className="choice__body">
              <span className="choice__title">{option.title}</span>
              <span className="choice__text">{option.disabled && option.note ? option.note : option.text}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
