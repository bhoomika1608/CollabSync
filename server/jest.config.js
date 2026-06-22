/** @type {import('jest').Config} */
module.exports = {
  // WHY ts-jest: lets Jest consume TypeScript source directly without
  // a separate "npm run build" step before every test run.
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Point ts-jest at the extended tsconfig so both src/ and tests/
        // share the same compiler options and module resolution.
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  // Collect coverage from source, not compiled output
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
};
