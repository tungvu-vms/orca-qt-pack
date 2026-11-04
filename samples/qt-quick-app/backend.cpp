#include "backend.h"

Backend::Backend(QObject *parent) : QObject(parent) {}

int Backend::count() const { return m_count; }

void Backend::increment()
{
    ++m_count;
    emit countChanged();
}

QString Backend::title() const { return QStringLiteral("Count: %1").arg(m_count); }