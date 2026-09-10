"use client";

import { useEffect, useRef, useState, type ComponentProps, type SyntheticEvent } from "react";
import dynamic from "next/dynamic";
import ImageOff from "lucide-react/dist/esm/icons/image-off.js";
import { canOptimizeListingPhoto } from "@/lib/listing-photo-source";

const Image = dynamic(() => import("next/image"));

type Props = Omit<ComponentProps<"img">, "src" | "alt"> & {
  src: string;
  alt: string;
  compactFallback?: boolean;
};

export function ListingPhoto(props: Props) {
  return <Photo key={props.src} {...props} />;
}

function Photo({
  src,
  alt,
  onError,
  compactFallback = false,
  width,
  height,
  srcSet,
  sizes,
  ...props
}: Props) {
  const [failed, setFailed] = useState(false);
  const [originalOnly, setOriginalOnly] = useState(false);
  const optimized = canOptimizeListingPhoto(src) && !originalOnly;
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && !image.naturalWidth) {
      if (optimized) setOriginalOnly(true);
      else setFailed(true);
    }
  }, [optimized]);

  if (failed) {
    return (
      <span
        role={alt ? "img" : undefined}
        aria-label={alt ? `${alt} : indisponible` : undefined}
        aria-hidden={alt ? undefined : true}
        className="flex h-full min-h-20 w-full items-center justify-center bg-muted px-4 text-center text-sm text-foreground"
      >
        {compactFallback ? <ImageOff className="h-5 w-5" aria-hidden /> : "Photo indisponible"}
      </span>
    );
  }

  const imageProps = {
    ...props,
    src,
    alt,
    ref: imageRef,
    onError: (event: SyntheticEvent<HTMLImageElement>) => {
      if (optimized) setOriginalOnly(true);
      else setFailed(true);
      onError?.(event);
    },
  };

  return optimized ? (
    <span className="relative block h-full w-full">
      <Image
        {...imageProps}
        fill
        sizes={sizes ?? "(max-width: 767px) calc(100vw - 32px), (max-width: 1280px) 50vw, 720px"}
        loading={props.loading ?? (props.fetchPriority === "high" ? "eager" : "lazy")}
      />
    </span>
  ) : (
    <img {...imageProps} width={width} height={height} srcSet={srcSet} sizes={sizes} />
  );
}
