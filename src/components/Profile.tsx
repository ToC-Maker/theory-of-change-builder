import { useAuth0 } from '@auth0/auth0-react';

const Profile = () => {
  const { user, isAuthenticated, isLoading } = useAuth0();

  if (isLoading) {
    return <div className="text-gray-600">Loading profile...</div>;
  }

  return isAuthenticated && user ? (
    <div className="flex flex-col items-center gap-4">
      {user.picture && (
        <img
          src={user.picture}
          alt={user.name || 'User'}
          className="w-20 h-20 rounded-full object-cover border-2 border-blue-500"
        />
      )}
      <div className="text-center">
        <div className="text-xl font-semibold text-gray-800">{user.name}</div>
        <div className="text-sm text-gray-600">{user.email}</div>
      </div>
    </div>
  ) : null;
};

export default Profile;
