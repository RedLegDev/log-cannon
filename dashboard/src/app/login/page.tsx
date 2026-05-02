"use client";

import { useState, useRef, KeyboardEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();

  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState<string[]>(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Failed to send code.");
        return;
      }
      setStep(2);
      setTimeout(() => otpRefs.current[0]?.focus(), 50);
    } catch {
      setError("Failed to send code. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = otp.join("");
    if (code.length !== 6) {
      setError("Please enter the full 6-digit code.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = (await res.json()) as { valid?: boolean; error?: string };
      if (!res.ok || !data.valid) {
        setError(data.error || "Invalid code. Please try again.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Verification failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpChange = (index: number, value: string) => {
    if (value.length > 1) {
      const digits = value.replace(/\D/g, "").slice(0, 6).split("");
      const newOtp = [...otp];
      digits.forEach((d, i) => {
        if (index + i < 6) newOtp[index + i] = d;
      });
      setOtp(newOtp);
      const nextIndex = Math.min(index + digits.length, 5);
      otpRefs.current[nextIndex]?.focus();
      return;
    }

    if (!/^\d?$/.test(value)) return;

    const newOtp = [...otp];
    newOtp[index] = value;
    setOtp(newOtp);

    if (value && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (
    index: number,
    e: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-cannon-black px-4">
      <div className="w-full max-w-sm bg-cannon-charcoal rounded-2xl p-8 shadow-xl border border-cannon-graphite">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-3">
            <svg viewBox="0 0 64 64" fill="none" className="w-full h-full">
              <circle cx="32" cy="32" r="30" fill="#0A0A0B" />
              <rect x="12" y="24" width="24" height="16" rx="3" fill="#FF4D2A" />
              <circle cx="20" cy="40" r="7" fill="#141416" stroke="#FF4D2A" strokeWidth="2.5" />
              <circle cx="20" cy="40" r="2" fill="#FF4D2A" />
              <rect x="40" y="26" width="14" height="4" rx="2" fill="#FF4D2A" opacity="0.9" />
              <rect x="44" y="32" width="12" height="4" rx="2" fill="#FF6B47" opacity="0.7" />
              <rect x="40" y="38" width="10" height="4" rx="2" fill="#FF8A65" opacity="0.5" />
            </svg>
          </div>
          <h1 className="font-mono text-2xl font-bold text-white tracking-tight">
            LOG <span className="text-cannon-fire">CANNON</span>
          </h1>
          <p className="mt-2 text-sm text-gray-400">
            {step === 1
              ? "Sign in with your email"
              : `Enter the code sent to ${email}`}
          </p>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {step === 1 ? (
          <form className="mt-6" onSubmit={handleSendCode}>
            <label className="sr-only" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email address"
              className="w-full rounded-lg border border-cannon-graphite bg-cannon-black px-4 py-3 text-sm text-white placeholder:text-gray-500 focus:border-cannon-fire focus:outline-none focus:ring-1 focus:ring-cannon-fire transition"
            />
            <button
              type="submit"
              disabled={loading || !email}
              className="mt-4 w-full rounded-lg bg-cannon-fire hover:bg-cannon-ember py-3 text-sm font-semibold text-white transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {loading ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form className="mt-6" onSubmit={handleVerify}>
            <div className="flex gap-2 justify-center">
              {otp.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    otpRefs.current[i] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  autoComplete={i === 0 ? "one-time-code" : "off"}
                  maxLength={6}
                  value={digit}
                  onChange={(e) => handleOtpChange(i, e.target.value)}
                  onKeyDown={(e) => handleOtpKeyDown(i, e)}
                  className="w-11 h-12 text-center text-lg font-bold rounded-lg border border-cannon-graphite bg-cannon-black text-white focus:border-cannon-fire focus:outline-none focus:ring-1 focus:ring-cannon-fire transition-colors"
                />
              ))}
            </div>
            <button
              type="submit"
              disabled={loading}
              className="mt-4 w-full rounded-lg bg-cannon-fire hover:bg-cannon-ember py-3 text-sm font-semibold text-white transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {loading ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStep(1);
                setOtp(["", "", "", "", "", ""]);
                setError("");
              }}
              className="mt-2 w-full text-center text-sm text-gray-400 hover:text-gray-300 cursor-pointer transition-colors"
            >
              Back
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-xs text-gray-500">
          Authorized users only
        </p>
      </div>
    </div>
  );
}
