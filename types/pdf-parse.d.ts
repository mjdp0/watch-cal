declare module "pdf-parse" {
  interface PdfData {
    text: string;
    numpages?: number;
    info?: unknown;
  }
  function pdfParse(data: Buffer): Promise<PdfData>;
  export default pdfParse;
}
