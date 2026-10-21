// Fixture rules for the custom-rules tests.

export default [
  {
    id: 'employee-id',
    label: 'EMPLOYEE_ID',
    description: 'Internal employee identifiers',
    pattern: /\bEMP-\d{6}\b/g,
  },
];
