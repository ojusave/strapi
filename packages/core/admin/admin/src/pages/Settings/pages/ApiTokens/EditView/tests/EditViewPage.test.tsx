import { render, waitFor } from '@tests/utils';

import { EditView } from '../EditViewPage';

describe('ADMIN | Pages | API TOKENS | EditView', () => {
  describe('create mode (defaults to admin kind)', () => {
    it('renders the create form and hides token type selector', async () => {
      const { findByText, queryByText } = render(<EditView />, {
        initialEntries: ['/settings/api-tokens/create'],
      });

      // Form fields are present
      await findByText('Name');
      await findByText('Description');

      // Token type selector must not be present for admin kind
      expect(queryByText('Token type')).toBeNull();
    });
  });

  describe('edit mode — content-api token (id: 1)', () => {
    it('renders content permissions and token type selector', async () => {
      const { findByText } = render(<EditView />, {
        initialEntries: ['/settings/api-tokens/1'],
      });

      await findByText('My super token');
      await findByText('This describe my super token');
      await findByText('Regenerate');
      // Content-API permissions section is shown
      await findByText('Address');
      // Token type selector is present
      await findByText('Token type');
    });

    it('does not render admin permissions matrix', async () => {
      const { findByText, queryByText } = render(<EditView />, {
        initialEntries: ['/settings/api-tokens/1'],
      });

      await findByText('My super token');
      // Admin matrix section title must not be present
      expect(queryByText('Plugins and Settings')).toBeNull();
    });
  });

  describe('edit mode — admin token (id: 2)', () => {
    it('renders admin permissions matrix and hides token type selector', async () => {
      const { findByText, queryByText } = render(<EditView />, {
        initialEntries: ['/settings/api-tokens/2'],
      });

      await findByText('My admin token');
      await findByText('This is an admin token');

      // Token type selector must not be present for admin kind
      expect(queryByText('Token type')).toBeNull();
    });

    it('hides content-api permissions section', async () => {
      const { findByText, queryByText } = render(<EditView />, {
        initialEntries: ['/settings/api-tokens/2'],
      });

      await findByText('My admin token');
      // Wait for async updates to settle, then assert absence of content-api section
      await waitFor(() => {
        expect(queryByText('Bound route to')).toBeNull();
      });
    });
  });
});
