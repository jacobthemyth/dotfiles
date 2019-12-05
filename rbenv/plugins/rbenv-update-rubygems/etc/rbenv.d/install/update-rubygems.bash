# Based on rbenv-default-gems

if declare -Ff after_install >/dev/null; then
  after_install update_rubygems
else
  echo "rbenv: rbenv-default-gems plugin requires ruby-build 20130129 or later" >&2
fi

update_rubygems() {
  # Only update rubygems after successfully installing Ruby.
  [ "$STATUS" = "0" ] || return 0

  # update all gems that come with ruby
  RBENV_VERSION="$VERSION_NAME" rbenv-exec gem update

  # update rubygems
  RBENV_VERSION="$VERSION_NAME" rbenv-exec gem update --system

  # cleanup old gems
  RBENV_VERSION="$VERSION_NAME" rbenv-exec gem cleanup
}
