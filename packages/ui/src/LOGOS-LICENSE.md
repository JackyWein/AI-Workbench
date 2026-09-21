# Logo sources and licenses

`logos.ts` is generated from two icon collections. The application uses the
marks only to identify the tools and services a person connects; every logo is
a trademark of its respective owner, and its use here implies no endorsement.

## AI tools and models — @lobehub/icons-static-svg 1.95.1

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Services — simple-icons 16.32.0

CC0 1.0 Universal (public domain dedication). See
https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md and the
project's disclaimer on the use of brand marks.

## Regenerating

The generator reads the two npm packages and writes `logos.ts`: titles are
dropped, width, height and style attributes removed, and service marks whose
brand colour is too dark or too light for one of the themes are drawn in
`currentColor` instead.
