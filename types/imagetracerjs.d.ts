declare module 'imagetracerjs' {
  const ImageTracer: {
    imagedataToSVG: (imageData: ImageData, options?: string | Record<string, unknown>) => string;
  };
  export default ImageTracer;
}
