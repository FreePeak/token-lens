import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";

export function CopyPathButton({ path }: { path: string | null | undefined }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  if (!path) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      title="Copy session path"
      onClick={() => {
        navigator.clipboard.writeText(path).then(() => setCopied(true));
      }}
    >
      {copied ? (
        <Check className="h-4 w-4 mr-1 text-green-500" />
      ) : (
        <Copy className="h-4 w-4 mr-1" />
      )}
      {copied ? "Copied!" : "Copy session path"}
    </Button>
  );
}
