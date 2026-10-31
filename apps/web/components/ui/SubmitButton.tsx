"use client";
// <SubmitButton>: a submit <Button> that shows its form's pending state within a frame of the press:
// useFormStatus for React form actions (<form action={serverAction}>), and the form's submit event for
// a plain HTML form (a POST that navigates, like sign-out). Resets if the page is restored from the
// back/forward cache.
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./Button";

export function SubmitButton({ pending, ...props }: Omit<ButtonProps, "type" | "ref">) {
  const status = useFormStatus();
  const ref = useRef<HTMLButtonElement>(null);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = (e: SubmitEvent) => {
      // Only a native submission that will navigate: React actions (and onSubmit handlers) prevent the
      // default, which is known once the event has finished dispatching; they report via useFormStatus.
      setTimeout(() => {
        if (!e.defaultPrevented) setSubmitted(true);
      }, 0);
    };
    const onShow = () => setSubmitted(false);
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
  return <Button {...props} ref={ref} type="submit" pending={pending || status.pending || submitted} />;
}
